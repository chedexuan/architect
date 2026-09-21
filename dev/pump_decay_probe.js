// Why does a pumpjack read 808/min over 30 seconds and 643/min over 120?
//
// The rig's own numbers agree with the ground (fluid leaving the field equals fluid arriving in the
// tank), so this is not a counting mistake -- the machine really gives less as the window grows.
// Sampling the same rig once per ten game seconds separates the shapes that look identical in an
// average: a start-up surge that amortises away, a step when something fills up, or a continuous
// decay. The pump's own box is read alongside, because "the box is full" and "the box is empty"
// are different machines: one is being pushed back by the network, the other is mining as fast as
// it can and the ground is the limit.
//
// Rates are per minute. Raw entities on nauvis, on the crude field dev/oilfield.js plants; dev/cycle.sh restarts from the
// save, so nothing here persists.
const connect = require("./rcon_client");
const r = connect();

const SAMPLES = Number(process.env.SAMPLES || 24);
const EVERY_GAME_SECONDS = 10;

const setup = `local s=game.surfaces["nauvis"]
local t=s.find_entities_filtered{name="crude-oil",type="resource"}
if #t==0 then rcon.print("NO_OILFIELD run dev/oilfield.js") return end
-- the centroid of a scattered field is usually empty ground: stand the pump on a tile that is
-- actually oil, the one nearest the middle
local cx,cy=0,0
for _,e in ipairs(t) do cx=cx+e.position.x cy=cy+e.position.y end
cx=cx/#t cy=cy/#t
local best, bd = t[1], nil
for _,e in ipairs(t) do
  local d=(e.position.x-cx)^2+(e.position.y-cy)^2
  if not bd or d<bd then bd=d best=e end
end
local px,py=math.floor(best.position.x)+0.5, math.floor(best.position.y)+0.5
-- only the probe's own kinds: a blanket area clear once deleted the oil field it was measuring
for _,e in ipairs(s.find_entities_filtered{name={"pumpjack","pipe","storage-tank","electric-energy-interface"},
                                           area={{px-14,py-14},{px+14,py+14}}}) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
local gen=s.create_entity{name="electric-energy-interface",position={px,py+8},force="player"}
local pump=s.create_entity{name="pumpjack",position={px,py},force="player"}
if not pump then rcon.print("PUMP_REFUSED") return end
local ring=0
for dx=-2,2 do for dy=-2,2 do
  local ax,ay=math.abs(dx),math.abs(dy)
  if (ax==2 and ay<=1) or (ay==2 and ax<=1) then
    local p={x=px+dx,y=py+dy}
    if s.can_place_entity{name="pipe",position=p,force="player"} then
      if s.create_entity{name="pipe",position=p,force="player"} then ring=ring+1 end
    end
  end
end end
-- One tank behind every arc, not one wherever it fits. The twelve "ring" tiles are four separate
-- three-pipe arcs -- the corners are left out by the loop that places them -- so a tank on one side
-- can only drain the arc on that side, and the pump blocks with the other three full of nothing.
local tanks, tank_units = {}, {}
for _,o in ipairs({{4,0,defines.direction.west},{-4,0,defines.direction.east},
                   {0,4,defines.direction.north},{0,-4,defines.direction.south}}) do
  local p={x=px+o[1],y=py+o[2]}
  if s.can_place_entity{name="storage-tank",position=p,force="player",direction=o[3]} then
    local tk=s.create_entity{name="storage-tank",position=p,force="player",direction=o[3]}
    if tk then tanks[#tanks+1]=tk tank_units[#tank_units+1]=tk.unit_number end
  end
end
if #tanks==0 then rcon.print("NO_TANK ring="..ring) return end
local tank=tanks[1]
storage_decay = {pump=pump.unit_number, tank=tank.unit_number, tanks=tank_units, px=px, py=py, ring=ring,
                 started=game.tick, last_ground=0, last_tank=0}
-- the baseline has to be the ground as it stands now, not zero: the first interval otherwise
-- reports the whole field as if it had just been mined
local function ground()
  local n=0
  for _,e in ipairs(s.find_entities_filtered{name="crude-oil",type="resource"}) do n=n+(e.amount or 0) end
  return n
end
storage_decay.g0 = ground()
storage_decay.last_ground = storage_decay.g0
rcon.print(string.format("built pump@%.1f,%.1f ring=%d tank=%s ground=%d", px, py, ring,
  tank.position.x..","..tank.position.y, storage_decay.g0))`;

// One sample: the interval's own rate, not the running average, plus the state of the three
// vessels the fluid passes through on its way out of the ground.
const sample = `local s=game.surfaces["nauvis"]
local d=storage_decay
if not d then rcon.print("NO_RIG") return end
local function held(e)
  local n=0
  pcall(function() for _,v in pairs(e.get_fluid_contents()) do n=n+((type(v)=="number") and v or (v.amount or 0)) end end)
  return n
end
local pump
for _,e in ipairs(s.find_entities_filtered{name="pumpjack",area={{d.px-4,d.py-4},{d.px+4,d.py+4}}}) do
  if e.unit_number==d.pump then pump=e end
end
if not pump then rcon.print("RIG_GONE") return end
local collected, full = 0, 0
for _,e in ipairs(s.find_entities_filtered{name="storage-tank",area={{d.px-12,d.py-12},{d.px+12,d.py+12}}}) do
  collected = collected + held(e)
  full = full + 1
end
local ring=0
for _,e in ipairs(s.find_entities_filtered{name="pipe",area={{d.px-4,d.py-4},{d.px+4,d.py+4}}}) do ring=ring+held(e) end
local ground=0
for _,e in ipairs(s.find_entities_filtered{name="crude-oil",type="resource"}) do ground=ground+(e.amount or 0) end
local t=(game.tick-d.started)/60
local dt=t-(d.last_t or 0)
local gain=collected-d.last_tank
local out=d.last_ground-ground
d.last_tank, d.last_ground, d.last_t = collected, ground, t
local rev={} for k,v in pairs(defines.entity_status) do rev[v]=k end
local box=held(pump)
-- a key the entity does not have raises rather than returning nil, so every optional figure goes
-- through one guarded read
local function peek(f) local ok,v=pcall(f) return ok and v or "n/a" end
local progress=peek(function() return string.format("%.3f", pump.mining_progress) end)
local target=peek(function() return pump.mining_target and pump.mining_target.name or "-" end)
rcon.print(string.format(
  "t=%5.1fs  ground=%7.2f/min  tanks=%7.2f/min  ground-= %6d  collected=%8.1f (%d/%d tanks, %.2f%%)  arcs=%6.1f  box=%5.1f  progress=%s  status=%s",
  t, dt>0 and (out/dt*60) or 0, dt>0 and (gain/dt*60) or 0, out, collected, full, d.tanks and #d.tanks or 0,
  full>0 and (100*collected/(prototypes.entity["storage-tank"].fluid_capacity*full)) or 0,
  ring, box, progress, tostring(rev[pump.status])))
`;

const teardown = `local s=game.surfaces["nauvis"]
local d=storage_decay
if d then
  for _,e in ipairs(s.find_entities_filtered{name={"pumpjack","pipe","storage-tank","electric-energy-interface"},
                                             area={{d.px-14,d.py-14},{d.px+14,d.py+14}}}) do e.destroy() end
end
storage_decay=nil
rcon.print("cleared")`;

(async () => {
  await r.ready();
  console.log(await r.cmd(teardown));
  console.log(await r.cmd(setup));
  // speed 8 keeps the wall-clock cost honest: 10 game seconds is 1.25s of real time, and the game
  // is left running between samples rather than advanced inside one command
  await r.runFor(500, 8);
  for (let i = 0; i < SAMPLES; i++) {
    await r.runFor(1250, 8);
    console.log(await r.cmd(sample));
  }
  console.log(await r.cmd(teardown));
  r.close();
})();
