// Does an `electric-energy-interface` on the global grid actually supply a machine, and does it
// matter which surface? The lab measured assembling-machine-1 producing on this grid, so if a
// hand-placed pair does not run, the difference is somewhere other than the surface -- and a
// pumpjack rate measured while the pump says `no_power` is not a rate at all.
const connect = require("./rcon_client");
const r = connect();

(async () => {
  await r.ready();
  let sb = null;
  for (let i = 0; i < 20; i++) {
    const out = await r.cmd(`local ok,res=pcall(function() return remote.call("arch","call","sandbox",{}) end) rcon.print(tostring(res))`);
    if (out.indexOf('"ready":true') >= 0 || out.indexOf('"ready": true') >= 0) { sb = out; break; }
    console.log("waiting:", out.slice(0, 120));
    await new Promise((s) => setTimeout(s, 500));
  }
  console.log("sandbox:", (sb || "never ready").slice(0, 200));

  // surface A: the sandbox; surface B: nauvis. Same rig on both.
  for (const name of ["arch-sandbox", "nauvis"]) {
    console.log(name, await r.cmd(`local s=game.surfaces["${name}"]
if not s then rcon.print("no surface") return end
s.create_global_electric_network()
local function st(p) local k="?" for key,v in pairs(defines.entity_status) do if v==p.status then k=key end end return k end
local g=s.create_entity{name="electric-energy-interface",position={x=60.5,y=60.5},force="player"}
local a=s.create_entity{name="assembling-machine-1",position={x=64.5,y=60.5},force="player"}
rcon.print(string.format("gen_net=%s asm_net=%s status=%s energy=%s",
  tostring(g and g.electric_network_id), tostring(a and a.electric_network_id), st(a), tostring(a.energy)))`));
  }

  await r.runFor(3000, 20);

  for (const name of ["arch-sandbox", "nauvis"]) {
    console.log("after", name, await r.cmd(`local s=game.surfaces["${name}"]
local out={}
for _,a in ipairs(s.find_entities_filtered{name="assembling-machine-1"}) do
  local k="?" for key,v in pairs(defines.entity_status) do if v==a.status then k=key end end
  out[#out+1]=string.format("%.0f,%.0f status=%s energy=%.0f",a.position.x,a.position.y,k,a.energy or -1)
end
rcon.print(table.concat(out," | "))`));
  }

  console.log("cleanup", await r.cmd(`for _,n in ipairs({"assembling-machine-1","electric-energy-interface"}) do
for _,s in pairs(game.surfaces) do for _,e in ipairs(s.find_entities_filtered{name=n}) do e.destroy() end end end
game.tick_paused=false game.speed=1 rcon.print("done")`));
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
