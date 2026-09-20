// Why is a burner drill placed on a real patch mining nothing? Read its own answers.
const connect = require("./rcon_client");
const r = connect();
const S = 'game.surfaces["nauvis"]';

(async () => {
  await r.ready();
  console.log(await r.cmd(`local s=${S}
local t=s.find_entities_filtered{name="iron-ore",type="resource",limit=400}
local p=t[200].position
local d=s.create_entity{name="burner-mining-drill",position={x=p.x+0.5,y=p.y+0.5},force="player"}
if not d then rcon.print("cannot place") return end
local nm="?" for k,v in pairs(defines.entity_status) do if v==d.status then nm=k end end
local okf,fu=pcall(function() return d.get_inventory(defines.inventory.fuel) end)
local ins=okf and fu and select(2,pcall(function() return fu.insert({name="coal",count=20}) end))
local oks,si=pcall(function() return d.get_inventory(defines.inventory.chest) end)
rcon.print(string.format("at %.1f,%.1f status=%s energy=%.1f fuel=%s fuel_inserted=%s chest=%s",
  p.x,p.y,nm,d.energy or -1,tostring(okf and fu and fu.get_item_count()),tostring(ins),tostring(oks and si and si.get_item_count())))`));

  await r.runFor(3000, 40);

  console.log(await r.cmd(`local s=${S}
local out={}
for _,d in ipairs(s.find_entities_filtered{name="burner-mining-drill"}) do
  local k="?" for key,v in pairs(defines.entity_status) do if v==d.status then k=key end end
  local line="status="..k.." energy="..tostring(d.energy)
  local okf,fu=pcall(function() return d.get_inventory(defines.inventory.fuel) end)
  line=line.." fuel="..tostring(okf and fu and fu.get_item_count())
  for _,name in ipairs({"mining_progress","resources_created","crafting_progress"}) do
    local ok,v=pcall(function() return d[name] end) line=line.." "..name.."="..tostring(ok and v or "n/a")
  end
  local oko,op=pcall(function() return d.get_inventory(defines.inventory.chest) end)
  line=line.." chest="..tostring(oko and op and op.get_item_count())
  local okc,cnt=pcall(function() return s.count_items_filtered{name="iron-ore"} end)
  out[#out+1]=line.." | drill_inv_probe="..tostring(d.get_inventory and "yes" or "no")
  d.destroy()
end
rcon.print(table.concat(out," ;; "))`));
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
