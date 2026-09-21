// Does 2.0 let a script READ a machine's fluid boxes, or must they stay measured?
//
// The conclusion this mod has been built on since A1 is that fluid boxes are unreadable: 1.1's
// `entity.fluidbox[i]` answers nothing (`#fluidbox` is 0), so where a box lives was only ever
// established by offering fluid one cell at a time (`fluidrig`), and the answers were frozen into
// `boxes.lua`. The 2.0 API describes `LuaEntity.fluidbox` as a `LuaFluidBox` -- an object whose
// methods take an index (`get_capacity(i)`, `get_fluid_segment_contents(i)`, `get_connections(i)`,
// `get_pipe_connections(i)`) -- and `LuaFluidBoxPrototype` exposes `pipe_connections`, `volume`,
// `filter` and min/max temperature as data. If those are readable, the geometry is a fact the rules
// can look up and the rig becomes the verifier rather than the only witness.
//
// So this asks each of those questions of the engine and prints whatever it says, including the
// errors. Nothing here asserts; it is the step before deciding what to assert. Read-only apart from
// two pipes and one refinery on the lab surface, cleaned up at the end.
const r = require("./rcon_client")();

const PRELUDE = `local function f(o,k) if o==nil then return nil end
  local ok,v=pcall(function() return o[k] end) if not ok then return nil, tostring(v) end return v end
local function pos(p) if type(p)~="table" then return tostring(p) end
  local x,y = p.x or p[1], p.y or p[2]
  if type(x)~="number" or type(y)~="number" then return helpers.table_to_json(p) end
  return string.format("%.2f,%.2f", x, y) end
local function any(v)
  if type(v) ~= "table" then return tostring(v) end
  local parts = {}
  for k, val in pairs(v) do parts[#parts+1] = tostring(k) .. "=" .. (type(val)=="table" and any(val) or tostring(val)) end
  table.sort(parts)
  return "{" .. table.concat(parts, " ") .. "}"
end
local s = game.surfaces["arch-sandbox"]`;

// the data-stage answer, which needs no entity at all: what does the prototype say per box?
const protoDump = `local NAMES = {"oil-refinery","pumpjack","boiler","steam-turbine","steam-engine","pipe",
  "storage-tank","assembling-machine-3","chemistry-stalag","foundry","flare-stack","offshore-pump"}
for _, n in ipairs(NAMES) do
  local p = prototypes.entity[n]
  if not p then rcon.print(n .. ": NO PROTOTYPE") goto continue end
  local bfs = f(p, "fluidbox_prototypes")
  rcon.print(string.format("%s tiles=%dx%d boxes=%s", n, (f(p,"tile_width") or 0), (f(p,"tile_height") or 0),
    bfs and #bfs or "none"))
  if bfs then
    for i, b in ipairs(bfs) do
      local pc = f(b, "pipe_connections")
      rcon.print(string.format("  box %d type=%-12s volume=%-8s filter=%-14s minT=%-6s maxT=%-6s pipes=%s",
        i, tostring(f(b,"production_type")), tostring(f(b,"volume")),
        tostring(f(b,"filter") and f(f(b,"filter"),"name")), tostring(f(b,"minimum_temperature")),
        tostring(f(b,"maximum_temperature")), any(pc)))
    end
  end
  local cap = select(2, pcall(function() return p.get_fluid_capacity("normal") end))
  local usage = select(2, pcall(function() return p.get_fluid_usage_per_tick("normal") end))
  rcon.print("  get_fluid_capacity=" .. tostring(cap) .. " get_fluid_usage_per_tick=" .. tostring(usage)
    .. " target_temperature=" .. tostring(f(p,"target_temperature"))
    .. " maximum_temperature=" .. tostring(f(p,"maximum_temperature")))
  ::continue::
end`;

// the live-entity answer: can a placed machine be asked, index by index?
const liveDump = `if not s then rcon.print("NO_SANDBOX") return end
for _, e in ipairs(s.find_entities_filtered{area={{-30,-30},{30,30}}}) do e.destroy() end
local function ask(fb, method, i)
  -- 2.0's LuaFluidBox methods take the index alone: passing the object as self raises
  -- "Arguments count error", which is what made this look unreadable on the first pass
  local ok, v = pcall(function() return fb[method](i) end)
  if not ok then return "RAISED " .. tostring(v):sub(1, 120) end
  return any(v)
end
local function dump(e, label)
  local fb = e.fluidbox
  rcon.print(string.format("%s (%s @ %s) fluidbox=%s object_name=%s", label, e.name,
    pos(e.position), tostring(fb), tostring(f(fb, "object_name"))))
  local len = select(2, pcall(function() return #fb end))
  rcon.print("  #fluidbox=" .. tostring(len) .. " [1]=" .. tostring(select(2, pcall(function() return fb[1] end)))
    .. " fluids_count=" .. tostring(select(2, pcall(function() return e.fluids_count end))))
  for i = 1, 6 do
    local cap = ask(fb, "get_capacity", i)
    local seg = ask(fb, "get_fluid_segment_contents", i)
    if cap ~= "RAISED Out of bounds index" then
      rcon.print(string.format("  [%d] capacity=%s filter=%s locked=%s proto=%s", i,
        cap, ask(fb, "get_filter", i), ask(fb, "get_locked_fluid", i), ask(fb, "get_prototype", i)))
      rcon.print("      segment_contents=" .. seg)
      rcon.print("      connections=" .. ask(fb, "get_connections", i))
      rcon.print("      pipe_connections=" .. ask(fb, "get_pipe_connections", i))
      rcon.print("      segment_id=" .. ask(fb, "get_fluid_segment_id", i)
        .. " extent_box=" .. ask(fb, "get_fluid_segment_extent_bounding_box", i))
    end
  end
  rcon.print("  get_fluid_contents=" .. tostring(select(2, pcall(function() return e.get_fluid_contents() end))))
  for i = 1, 4 do
    local ok, fl = pcall(function() return e.get_fluid(i) end)
    if ok and fl then rcon.print(string.format("  get_fluid(%d) -> %s name=%s amount=%s temperature=%s",
      i, tostring(f(fl,"object_name")), any(f(fl,"name")), any(f(fl,"amount")), any(f(fl,"temperature")))) end
  end
end
for _, spec in ipairs({ {"oil-refinery", {0.5, 0.5}, "east"}, {"pumpjack", {8.5, 8.5}, nil},
  {"boiler", {-8.5, 4.5}, nil}, {"pipe", {2.5, 0.5}, nil} }) do
  local e = s.create_entity { name = spec[1], position = spec[2], force = "player",
    direction = spec[3] and defines.direction[spec[3]] or nil }
  if e then dump(e, spec[1] .. (spec[3] or "")) else rcon.print(spec[1] .. " REFUSED") end
end
rcon.print("now with fluid in it: two hot-cold offers into the refinery")
local ref = s.find_entities_filtered{name="oil-refinery", area={{-30,-30},{30,30}}}[1]
if ref then
  for _, req in ipairs({{name="crude-oil", amount=50, temperature=25}, {name="water", amount=50, temperature=80}}) do
    local ok, v = pcall(function() return ref.insert_fluid(req) end)
    rcon.print("  insert " .. req.name .. "@" .. req.temperature .. " -> " .. tostring(ok) .. " " .. tostring(v))
  end
  local fb = ref.fluidbox
  for i = 1, 6 do
    local ok, cap = pcall(function() return fb.get_capacity(i) end)
    if ok and type(cap) == "number" and cap > 0 then
      local o2, seg = pcall(function() return fb.get_fluid_segment_contents(i) end)
      rcon.print(string.format("  box %d capacity=%s segment=%s", i, tostring(cap), o2 and any(seg) or tostring(seg)))
    end
  end
end
for _, e in ipairs(s.find_entities_filtered{area={{-30,-30},{30,30}}}) do e.destroy() end
rcon.print("cleared")`;

(async () => {
  await r.ready();
  const run = async (label, body) => {
    console.log(`\n### ${label}`);
    console.log(await r.cmd(PRELUDE + "\n" + body));
  };
  await run("sanity", "rcon.print('sandbox=' .. tostring(s ~= nil) .. ' base=' .. game.active_mods.base)");
  await run("what the prototypes say, per box", protoDump);
  await run("what a placed entity says, per box", liveDump);
  r.close();
})();
