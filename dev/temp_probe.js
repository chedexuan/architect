// A3 groundwork: where temperature actually lives in this install's data, and what constrains it.
//
// The mod already carries a product's temperature and reads a fluid instance's temperature out of a
// machine, but nothing matches a producer's figure against a consumer's -- so heavy oil and light oil
// are one fluid to the planner, and hot water and cold water are too. Before writing a rule for that,
// the claim has to be checked against the data rather than against 1.1 memories: which recipes gate on
// temperature, which boxes do, which fuels pay differently by temperature, and how wide the ranges
// are. Everything but the last phase is read-only.
//
// The last phase is the one data cannot answer: does the engine enforce a temperature at runtime, and
// does fluid keep the temperature it arrived with through a machine? `insert_fluid{temperature=}` is
// how the question gets asked. Run after `bash dev/cycle.sh`.
const { execFileSync } = require("child_process");
const r = require("./rcon_client")();

const PRELUDE = `local function f(o,k) if o==nil then return nil end
  local ok,v=pcall(function() return o[k] end) return ok and v or nil end
local s = game.surfaces["arch-sandbox"]`;

const fluids = `local vary, hot, rows, n = 0, 0, {}, 0
for name, p in pairs(prototypes.fluid) do
  n = n + 1
  local d, mx, hc = f(p,"default_temperature"), f(p,"max_temperature"), f(p,"heat_capacity")
  if (d or 0) ~= (mx or 0) then vary = vary + 1 end
  if (mx or 0) > 80 then hot = hot + 1 end
  if (hc or 0) > 0 or (mx or 0) > 0 then
    rows[#rows+1] = string.format("  %-24s default=%-6s max=%-6s heat_cap=%-10s gas=%-6s fuel=%s",
      name, tostring(d), tostring(mx), tostring(hc), tostring(f(p,"gas_temperature")),
      tostring(f(p,"fuel_value")))
  end
end
table.sort(rows)
rcon.print(string.format("fluids=%d  default below max=%d  max above 80=%d  rows=%d", n, vary, hot, #rows))
rcon.print(table.concat(rows, "\\n"))`;

const recipes = `local ing, pro, n, fluid_ing = {}, {}, 0, 0
for _, r in pairs(prototypes.recipe) do
  n = n + 1
  for _, i in ipairs(f(r,"ingredients") or {}) do
    if f(i,"name") and f(i,"type") == "fluid" then fluid_ing = fluid_ing + 1 end
    if f(i,"temperature") or f(i,"minimum_temperature") or f(i,"maximum_temperature") then
      ing[#ing+1] = string.format("  %-34s %s in  T=%s min=%s max=%s", r.name, f(i,"name") or "?",
        tostring(f(i,"temperature")), tostring(f(i,"minimum_temperature")), tostring(f(i,"maximum_temperature")))
    end
  end
  for _, p in ipairs(f(r,"products") or {}) do
    if f(p,"temperature") then
      pro[#pro+1] = string.format("  %-34s %s out T=%s x%s", r.name, f(p,"name") or "?",
        tostring(f(p,"temperature")), tostring(f(p,"amount") or f(p,"amount_min")))
    end
  end
end
rcon.print(string.format("recipes=%d fluid ingredients=%d  gated by temperature=%d  yielding a stated temperature=%d",
  n, fluid_ing, #ing, #pro))
table.sort(ing) table.sort(pro)
rcon.print("ingredient gates:\\n" .. table.concat(ing, "\\n"))
rcon.print("product temperatures:\\n" .. table.concat(pro, "\\n"))`;

const boxes = `local gated, filtered, n = {}, {}, 0
for _, e in pairs(prototypes.entity) do
  local bfs = f(e, "fluidbox_prototypes")
  if bfs then
    for i, b in ipairs(bfs) do
      n = n + 1
      local mn, mx, flt = f(b,"minimum_temperature"), f(b,"maximum_temperature"), f(b,"filter")
      local fname = flt and f(flt,"name") or nil
      if (mn and mn > 0) or (mx and mx > 0) then
        gated[#gated+1] = string.format("  %-26s box %d %s  min=%s max=%s filter=%s",
          e.name, i, tostring(f(b,"production_type")), tostring(mn), tostring(mx), tostring(fname))
      end
      if fname then
        filtered[#filtered+1] = string.format("  %-26s box %d filter=%-14s volume=%s min=%s max=%s",
          e.name, i, fname, tostring(f(b,"volume")), tostring(mn), tostring(mx))
      end
    end
  end
end
table.sort(gated) table.sort(filtered)
rcon.print(string.format("readable fluidboxes=%d  gated by temperature=%d  with a fluid filter=%d",
  n, #gated, #filtered))
rcon.print("temperature-gated boxes (first 24):\\n" .. table.concat(gated, "\\n", 1, math.min(#gated, 24)))
rcon.print("filtered boxes (first 24):\\n" .. table.concat(filtered, "\\n", 1, math.min(#filtered, 24)))`;

const fuels = `local rows = {}
for _, e in pairs(prototypes.entity) do
  for si, src in ipairs(f(e, "energy_sources") or {}) do
    local mx, bf = f(src, "maximum_temperature"), f(src, "burns_fluid")
    local box = f(src, "fluid_box")
    if mx ~= nil or bf ~= nil then
      rows[#rows+1] = string.format("  %-26s src %d burns=%s max_T=%s scale=%s usage/tick=%s box min/max=%s/%s",
        e.name, si, tostring(bf), tostring(mx), tostring(f(src,"scale_fluid_usage")),
        tostring(f(src,"fluid_usage_per_tick")),
        tostring(box and f(box,"minimum_temperature")), tostring(box and f(box,"maximum_temperature")))
    end
  end
end
table.sort(rows)
rcon.print("fluid energy sources carrying a temperature or burn rule: " .. #rows)
rcon.print(table.concat(rows, "\\n", 1, math.min(#rows, 24)))
for _, n in ipairs({"boiler","pipe","storage-tank","oil-refinery","pumpjack","assembling-machine-3"}) do
  local p = prototypes.entity[n]
  rcon.print(string.format("  %-14s target_temperature=%s maximum_temperature=%s", n,
    tostring(p and f(p,"target_temperature")), tostring(p and f(p,"maximum_temperature"))))
end`;

const rig = `if not s then rcon.print("NO_SANDBOX") return end
for _, e in ipairs(s.find_entities_filtered{area={{-20,-20},{20,20}}}) do e.destroy() end
local function give(e, req)
  local ok, v = pcall(function() return e.insert_fluid(req) end)
  return string.format("%s(%s)", tostring(ok), tostring(v))
end
local function show(what, e)
  if not e or not e.valid then rcon.print("  " .. what .. " GONE") return end
  local out = {}
  local okc, contents = pcall(function() return e.get_fluid_contents() end)
  if not okc then rcon.print("  " .. what .. " get_fluid_contents raised: " .. tostring(contents)) end
  for k, v in pairs((okc and contents) or {}) do
    out[#out+1] = string.format("%s amount=%s temp=%s",
      tostring(type(k)=="string" and k or (type(k)=="table" and k.name) or "?"),
      tostring(type(v)=="number" and v or (v and v.amount)),
      tostring(type(v)=="table" and v.temperature))
  end
  rcon.print("  " .. what .. " [" .. table.concat(out, " | ") .. "]")
end
-- can a script put fluid in at a temperature at all, and does it stay there?
local hot = s.create_entity{name="pipe", position={0.5,0.5}, force="player"}
rcon.print("pipe insert_fluid{water,100,temperature=250} -> "
  .. give(hot, {name="water", amount=100, temperature=250}))
show("hot pipe", hot)
rcon.print("second insert of cold into the full pipe -> "
  .. give(hot, {name="water", amount=100, temperature=10}))
show("hot pipe after offering cold", hot)
local cold = s.create_entity{name="pipe", position={1.5,0.5}, force="player"}
give(cold, {name="water", amount=100, temperature=10})
show("cold pipe beside it", cold)
local tank = s.create_entity{name="storage-tank", position={4.5,4.5}, force="player"}
rcon.print("tank insert_fluid{water,20000,temperature=250} -> "
  .. give(tank, {name="water", amount=20000, temperature=250}))
show("tank with hot water", tank)
rcon.print("tank insert of cold on top -> "
  .. give(tank, {name="water", amount=1000, temperature=10}))
show("tank after cold", tank)
-- the two boxes in the whole game that gate on temperature are the steam engine's and the
-- turbine's, both min=100 on steam: does the enforcement reach a script-driven insert?
local t = s.create_entity{name="steam-turbine", position={10.5,4.5}, force="player"}
rcon.print("turbine insert steam@50 -> " .. give(t, {name="steam", amount=200, temperature=50}))
show("turbine after 50 degree steam", t)
rcon.print("turbine insert steam@165 -> " .. give(t, {name="steam", amount=200, temperature=165}))
show("turbine after 165 degree steam", t)
-- a boiler states target_temperature=165 in data: does the steam it makes actually come out at 165?
local b = s.create_entity{name="boiler", position={14.5,10.5}, force="player"}
pcall(function() b.insert{name="coal", count=20} end)
rcon.print("boiler insert water@90 -> " .. give(b, {name="water", amount=200, temperature=90}))
show("boiler before running", b)
rcon.print("built: hot/cold pipes, a tank, a turbine and a boiler")`;

const rig_read = `if not s then rcon.print("NO_SANDBOX") return end
local function show(what, e)
  if not e or not e.valid then rcon.print("  " .. what .. " GONE") return end
  local out = {}
  local okc, contents = pcall(function() return e.get_fluid_contents() end)
  if not okc then rcon.print("  " .. what .. " get_fluid_contents raised: " .. tostring(contents)) end
  for k, v in pairs((okc and contents) or {}) do
    out[#out+1] = string.format("%s amount=%s temp=%s",
      tostring(type(k)=="string" and k or (type(k)=="table" and k.name) or "?"),
      tostring(type(v)=="number" and v or (v and v.amount)),
      tostring(type(v)=="table" and v.temperature))
  end
  rcon.print("  " .. what .. " [" .. table.concat(out, " | ") .. "]")
end
local pipes = s.find_entities_filtered{name="pipe", area={{-20,-20},{20,20}}}
rcon.print("pipes=" .. #pipes)
for i, p in ipairs(pipes) do show("pipe " .. i .. " @" .. string.format("%.1f,%.1f", p.position.x, p.position.y), p) end
for _, t in ipairs(s.find_entities_filtered{name="storage-tank", area={{-20,-20},{20,20}}}) do
  show("tank", t)
end
for _, n in ipairs({"steam-turbine", "boiler"}) do
  for _, e in ipairs(s.find_entities_filtered{name=n, area={{-20,-20},{20,20}}}) do
    local rev = {} for k, v in pairs(defines.entity_status) do rev[v] = k end
    show(n, e)
    local okp, kw = pcall(function() return e.electric_energy_usage_produced_per_tick end)
    rcon.print("  " .. n .. " status=" .. tostring(rev[e.status]) .. " produced_j_per_tick="
      .. tostring(okp and kw))
  end
end
for _, e in ipairs(s.find_entities_filtered{area={{-20,-20},{20,20}}}) do e.destroy() end
rcon.print("cleared")`;

(async () => {
  await r.ready();
  const run = async (label, body) => {
    console.log(`\n### ${label}`);
    console.log(await r.cmd(PRELUDE + "\n" + body));
  };
  await run("sanity", "rcon.print('sandbox=' .. tostring(s ~= nil) .. ' base=' .. game.active_mods.base)");
  await run("fluids", fluids);
  await run("recipes", recipes);
  await run("entity fluidboxes", boxes);
  await run("fluid-burning energy sources", fuels);
  await run("temperature through pipes and a tank", rig);
  // flow and mixing only happen while the game runs
  await r.runFor(4000, 20);
  await run("...after four seconds at speed 20", rig_read);
  r.close();
})();
