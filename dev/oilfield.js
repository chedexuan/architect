// Dev fixtures: known-size ore fields on land inside this save's map.
//
// This m0 map autoplaces coal/copper/iron/stone and no crude oil (regenerating from the map's own
// settings still produced zero patches), and the Space Age ores are absent too, so the fluid and
// off-world lines cannot be measured on it unless a field is synthesized.
//
// Coordinates are not assumed: the map is far smaller than it looks (land ends near +-80 and
// anything placed outside it is silently invalid), so a site is only used when the tile is land,
// no resource already stands there, and the engine agrees the extractor fits.
//
// Not product code: it only runs in dev, and a restart from m0.zip clears everything.
const connect = require("./rcon_client");
const r = connect();

const FIELDS = [
  // base, plus the Space Age resources under their real prototype names -- three of them are
  // fluid vents, so they are extracted by a pump and belong to the same measurement as oil
  { name: "crude-oil", w: 6, h: 6, extractor: "pumpjack" },
  { name: "uranium-ore", w: 6, h: 6, extractor: "electric-mining-drill" },
  { name: "calcite", w: 5, h: 5, extractor: "electric-mining-drill" },
  { name: "tungsten-ore", w: 5, h: 5, extractor: "electric-mining-drill" },
  { name: "fluorine-vent", w: 4, h: 4, extractor: "pumpjack" },
  { name: "sulfuric-acid-geyser", w: 4, h: 4, extractor: "pumpjack" },
  { name: "lithium-brine", w: 4, h: 4, extractor: "pumpjack" },
  { name: "scrap", w: 5, h: 5, extractor: "electric-mining-drill" },
];

(async () => {
  await r.ready();
  const taken = [];
  for (const f of FIELDS) {
    const lua = `local s=game.surfaces["nauvis"]
local NAME, W, H, EXTRACT = "${f.name}", ${f.w}, ${f.h}, "${f.extractor}"
local function land(x,y)
  local ok,t=pcall(function() return s.get_tile(x,y) end)
  if not ok then return false end
  local n=t.name
  return n ~= "out-of-map" and not string.find(n, "water")
end
for y=-56,56,4 do for x=-56,56,4 do
  local free=true
  for dx=-1,W+1 do for dy=-1,H+1 do
    if not land(x+dx,y+dy) then free=false break end
  end
  if not free then break end
  end
  if free and #s.find_entities_filtered{type="resource",area={{x-1,y-1},{x+W+1,y+H+1}}} == 0
     and #s.find_entities_filtered{area={{x-1,y-1},{x+W+1,y+H+1}}} == 0 then
    local cx,cy=x+math.floor(W/2)+0.5, y+math.floor(H/2)+0.5
    if s.can_place_entity{name=EXTRACT,position={x=cx,y=cy},force="player"} then
      local made,amount=0,nil
      for dx=0,W-1 do for dy=0,H-1 do
        local e=s.create_entity{name=NAME,position={x=x+dx+0.5,y=y+dy+0.5}}
        if e then made=made+1 amount=amount or e.amount end
      end end
      local fits=s.can_place_entity{name=EXTRACT,position={x=cx,y=cy},force="player"}
      rcon.print(string.format("%s at %d,%d tiles=%d/%d amount=%s centre=%.1f,%.1f extractor_fits=%s",
        NAME, x, y, made, W*H, tostring(amount), cx, cy, tostring(fits)))
      return
    end
  end
end end
rcon.print("${f.name}: no site")`;
    console.log(await r.cmd(lua));
    await new Promise((res) => setTimeout(res, 60));
  }
  const summary = await r.cmd(`local s=game.surfaces["nauvis"]
local out={} for _,n in ipairs({"crude-oil","uranium-ore","calcite","tungsten-ore","fluorine-vent","sulfuric-acid-geyser","lithium-brine","scrap"}) do
  out[#out+1]=n.."="..#s.find_entities_filtered{name=n,type="resource"}
end
rcon.print("on map now: "..table.concat(out," "))`);
  console.log(summary);
  r.close();
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
