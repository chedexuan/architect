// Which part of the lane is standing where the rig wants its tank?
//
// `card_lab` on a drinking lane lays its supply runs and then reports TANK_REFUSED for every machine,
// while the site search that chose the ground had already been told (by `card_lab`'s own probe card)
// that a storage tank goes two cells out from each machine's box face. One of those two answers is
// wrong, and the difference decides whether a lane that carries its own water row can be measured at
// all -- so this puts the lane on the ground, walks the same three cell offsets `fluidrig` would use,
// and prints what the engine says about each tank cell plus every entity actually standing in the 3x3.
//
// Raw entities on the bench; `dev/cycle.sh` restarts from the save, so nothing here persists.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("row_tank_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
const one = (s) => String(s).split(/\r?\n/)[0].trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const FLUID = "water";

const TECHS = ["automation", "automation-2", "concrete", "electronics", "logistics", "steel-processing",
  "fluid-handling"];
const LUA_TECHS = TECHS.map((t) => JSON.stringify(t)).join(",");
const before = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
const alreadyOn = {};
for (const pair of one(before).split(/\s+/)) {
  const [k, v] = pair.split("=");
  if (v === "true") alreadyOn[k] = true;
}
lua(`local f=game.forces.player
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);

const ex = call("card_example", { recipe: "concrete", machines: 3, machine: "assembling-machine-2" });
const card = ex.data || ex;
if (!card.name) { console.log("no card:", JSON.stringify(ex).slice(0, 300)); process.exit(1); }
const ents = card.entities || [];
const feed = (card.fluid_in || [])[0] || {};
console.log("card:", card.name, "entities=", ents.length, "port=", JSON.stringify(feed.port));

// Built for real on the bench, at the origin the rig would get: `card_place` puts live entities on the
// ground under a frozen name, which is the state the tank question is asked against.
const frozen = call("card_freeze", { card: Object.assign({}, card, { name: "row-tank-probe" }),
  allow_unmeasured: true });
if (!frozen.ok) { console.log("freeze failed:", frozen.code, frozen.msg); process.exit(1); }
const placed = call("card_place", { name: "row-tank-probe", surface: "arch-lab", ghosts: false });
call("card_forget", { name: "row-tank-probe" });
const pd = placed.data || {};
if (!placed.ok) { console.log("place failed:", placed.code, placed.msg); process.exit(1); }
const ox = pd.origin.x, oy = pd.origin.y;
console.log("placed at", ox, oy, "entities=", pd.placed || pd.made);

// The machine the row feeds, the face it feeds it at, and the three tank cells `fluidrig` would try.
// The arithmetic is written out here on purpose: this file is asking whether the rig's geometry and
// the ground agree, so it has to say where it thinks the tank would stand in its own words.
const machine_name = card.components.furnace;
const FACE = feed.face || "north";
const OFF0 = feed.off || 0;
const probe = lua(`local s = game.surfaces["arch-lab"]
local ox, oy = ${ox}, ${oy}
local face, off0 = "${FACE}", ${OFF0}
-- unit vectors, the same four the rig uses
local U = { north={0,-1}, south={0,1}, east={1,0}, west={-1,0} }
local u = U[face]
local ms = {}
for _, e in ipairs(s.find_entities_filtered{area={{ox-2,oy-2},{ox+40,oy+40}}, name="${machine_name}"}) do
  ms[#ms+1] = e
end
table.sort(ms, function(a,b) return a.position.x < b.position.x end)
local p = prototypes.entity["${machine_name}"]
local w, h = p.tile_width, p.tile_height
local span = (u[1] == 0) and w or h
local out = {}
for idx, m in ipairs(ms) do
  local d = span / 2 + 0.5
  local bx = m.position.x + d * u[1]
  local by = m.position.y + d * u[2]
  -- the three cells of that face, and the tank two beyond each
  local cells = {}
  for i = 0, span - 1 do cells[#cells+1] = i - (span - 1) / 2 end
  for _, c in ipairs(cells) do
    local cx = (u[1] == 0) and (bx + c) or (bx + 0)
    local cy = (u[2] == 0) and (by + c) or (by + 0)
    local tp = { x = cx + 2 * u[1], y = cy + 2 * u[2] }
    local dir
    if u[1] > 0 then dir = defines.direction.west
    elseif u[1] < 0 then dir = defines.direction.east
    elseif u[2] > 0 then dir = defines.direction.north
    else dir = defines.direction.south end
    local okcan = s.can_place_entity{name="storage-tank", position=tp, direction=dir, force="player"}
    local area = {{tp.x - 1.5, tp.y - 1.5}, {tp.x + 1.5, tp.y + 1.5}}
    local names = {}
    for _, e in ipairs(s.find_entities_filtered{area=area}) do
      if e.type ~= "tile" then names[#names+1] = e.name .. "@"
        .. string.format("%.1f,%.1f", e.position.x, e.position.y) end
    end
    out[#out+1] = string.format("m%d %.1f,%.1f cell=%.1f,%.1f tank=%.1f,%.1f can=%s [%s]",
      idx, m.position.x, m.position.y, cx, cy, tp.x, tp.y, tostring(okcan), table.concat(names, " "))
  end
end
rcon.print(table.concat(out, "\\n"))`);
console.log(probe);

// Does a full tank standing beyond the port actually hand its fluid to the lane's own row? The row is
// proven plumbing on its own (dev/fluid_row_e2e.js pours water in at the port and reads every pipe and
// every box holding it), so this asks only the one link `card_lab` now depends on: tank -> port pipe.
const link = lua(`local s = game.surfaces["arch-lab"]
local ox, oy = ${ox}, ${oy}
local face = "${FACE}"
local ms = s.find_entities_filtered{area={{ox-2,oy-2},{ox+60,oy+60}}, name="${machine_name}"}
table.sort(ms, function(a,b) return a.position.x < b.position.x end)
local m1 = ms[1]
if not m1 then rcon.print("NO_MACHINE") return end
local p = prototypes.entity["${machine_name}"]
local w = p.tile_width
-- the box cell of the first machine on its north face, and the port one cell west of it
local box = { x = m1.position.x, y = m1.position.y - (w / 2 + 0.5) }
local port = { x = box.x - 1, y = box.y }
local tank = { x = port.x - 2, y = port.y }
local pipes = {}
for _, pt in ipairs({box, port, {x=box.x-1, y=box.y}}) do
  local e = s.find_entities_filtered{area={{pt.x-0.4,pt.y-0.4},{pt.x+0.4,pt.y+0.4}}, name="pipe"}[1]
  pipes[#pipes+1] = string.format("%.1f,%.1f=%s", pt.x, pt.y, e and "pipe" or "EMPTY")
end
local t = s.create_entity{name="storage-tank", position=tank, direction=defines.direction.east, force="player"}
if not t then rcon.print("NO_TANK " .. table.concat(pipes," ")) return end
_G.RTP = { t = t }
local cap = 0
pcall(function() cap = t.get_fluid_box().buffer_capacity end)
local ok, err = pcall(function() return t.insert_fluid{name="${FLUID}", amount=cap > 0 and cap or 25000} end)
local out = {string.format("tank@%.1f,%.1f insert=%s %s", tank.x, tank.y, tostring(ok), tostring(err))}
local fb = 0
pcall(function() fb = #t.fluidbox end)
out[#out+1] = "tank_boxes="..fb
local joined = {}
pcall(function()
  for _, o in pairs(t.fluidbox.get_connections(1) or {}) do joined[#joined+1] = o.name or tostring(o) end
end)
out[#out+1] = "joined=["..table.concat(joined, " ").."]"
local held = 0
pcall(function() for _, v in pairs(t.get_fluid_contents()) do held = held + (tonumber(v) or 0) end end)
out[#out+1] = string.format("tank_held=%.0f", held)
rcon.print(table.concat(out, " | ") .. " | " .. table.concat(pipes, " "))`);
console.log("link:", one(link));
sleep(3000);
const after = lua(`local s = game.surfaces["arch-lab"]
local out = {}
local t = (_G.RTP or {}).t
if t and t.valid then
  local h = 0
  pcall(function() for _, v in pairs(t.get_fluid_contents()) do h = h + (tonumber(v) or 0) end end)
  out[#out+1] = string.format("tank_held=%.0f", h)
end
for _, m in ipairs(s.find_entities_filtered{area={{${ox}-2,${oy}-2},{${ox}+60,${oy}+60}}, name="${machine_name}"}) do
  local hb = 0
  pcall(function() for _, v in pairs(m.get_fluid_contents()) do hb = hb + (tonumber(v) or 0) end end)
  out[#out+1] = string.format("m@%.1f,%.1f box=%.0f", m.position.x, m.position.y, hb)
end
local wet, dry = 0, 0
for _, e in ipairs(s.find_entities_filtered{area={{${ox}-2,${oy}-2},{${ox}+60,${oy}+60}}, name="pipe"}) do
  local h = 0
  pcall(function() for _, v in pairs(e.get_fluid_contents()) do h = h + (tonumber(v) or 0) end end)
  if h > 0 then wet = wet + 1 else dry = dry + 1 end
end
out[#out+1] = "pipes_wet="..wet.." pipes_dry="..dry
rcon.print(table.concat(out, " | "))`);
console.log("after 3s:", one(after));

// Take the lane back out again, by the cells it was placed on.
const undone = lua(`local s = game.surfaces["arch-lab"]
local ox, oy = ${ox}, ${oy}
local n = 0
for _, e in ipairs(s.find_entities_filtered{area={{ox-4,oy-4},{ox+40,oy+40}}}) do
  if e.type ~= "resource" and e.type ~= "tile" then e.destroy() n = n + 1 end
end
rcon.print("destroyed="..n)`);
console.log("teardown:", one(undone));

lua(`local f=game.forces.player
local want={${Object.keys(alreadyOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",")}}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x and not want[t] then x.researched=false end
end
rcon.print("restored")`);
