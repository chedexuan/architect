// Live box index -> data box index, and the two outlet cells the frozen table does not have.
//
// `box_index_decide.js` settled one thing by accident: once a recipe is set, the refinery standing on
// the map has as many fluid boxes as that recipe needs -- two for basic oil processing (capacities 200
// and 100, ports at south +1 and north +2), five in the prototype. So a live box index and a recipe's
// `fluidbox_index` are different numbers, and the bridge has to be `get_prototype(i).index`. This
// reads that bridge for both oil recipes, and lays a pipe on every live port so the products are
// caught in the act: `advanced-oil-processing` yields three fluids, and which cell each one arrives in
// is exactly the half of the table that was never measured (heavy and light oil outlet cells are the
// gap `boxes.lua` still carries).
//
// The temperature rides along on purpose: crude is offered at 63 degrees rather than its default 25,
// so the read says whether a machine passes a fluid's temperature through to what it makes.
const r = require("./rcon_client")();

const PRELUDE = `local function f(o,k) if o==nil then return nil end
  local ok,v=pcall(function() return o[k] end) if not ok then return nil, tostring(v) end return v end
local function any(v)
  if type(v) ~= "table" then return tostring(v) end
  local parts = {}
  for k, val in pairs(v) do parts[#parts+1] = tostring(k) .. "="
    .. (type(val)=="table" and any(val) or tostring(val)) end
  table.sort(parts)
  return "{" .. table.concat(parts, " ") .. "}"
end
local function cell(p) if type(p) ~= "table" then return tostring(p) end
  return string.format("%.1f,%.1f", p.x or p[1], p.y or p[2]) end
local s = game.surfaces["arch-sandbox"]
local function held(e)
  local out = {}
  for k, v in pairs(e.get_fluid_contents()) do
    out[#out+1] = string.format("%s=%s@%s", tostring(type(k)=="string" and k or (type(k)=="table" and k.name) or "?"),
      tostring(type(v)=="number" and v or (v and v.amount)),
      tostring(type(v)=="table" and v.temperature))
  end
  table.sort(out)
  return table.concat(out, " ")
end
local AT = { 0.5, 0.5 }
local function describe(ref, tag)
  local fb = ref.fluidbox
  rcon.print(tag .. " live boxes: " .. #fb)
  for i = 1, #fb do
    local proto = select(2, pcall(function() return fb.get_prototype(i) end))
    local pc = select(2, pcall(function() return fb.get_pipe_connections(i) end))
    rcon.print(string.format("  live %d -> proto.index=%s kind=%-7s cap=%-5s filter=%-14s minT=%-5s maxT=%-5s port=%-11s pipe=%-11s holds=%s",
      i, tostring(proto and f(proto,"index")), tostring(pc and pc[1] and pc[1].flow_direction or "?"),
      tostring(select(2, pcall(function() return fb.get_capacity(i) end))),
      tostring(proto and f(proto,"filter") and f(f(proto,"filter"),"name")),
      tostring(proto and f(proto,"minimum_temperature")), tostring(proto and f(proto,"maximum_temperature")),
      cell(pc and pc[1] and pc[1].position), cell(pc and pc[1] and pc[1].target_position),
      any(select(2, pcall(function() return fb.get_fluid_segment_contents(i) end)))))
  end
end`;

const setup = (recipe) => `if not s then rcon.print("NO_SANDBOX") return end
for _, e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end
s.create_global_electric_network()
s.create_entity{name="electric-energy-interface", position={-14.5,-14.5}, force="player"}
local ref = s.create_entity{name="oil-refinery", position=${'{x=0.5,y=0.5}'}, force="player"}
local ok, err = pcall(function() return ref.set_recipe("${recipe}") end)
rcon.print("${recipe}: set_recipe " .. tostring(ok) .. " " .. tostring(err))
describe(ref, "before fluid")
-- a pipe on every live port: the products get caught wherever the engine chooses to put them
local laid = 0
local fb = ref.fluidbox
for i = 1, #fb do
  local pc = select(2, pcall(function() return fb.get_pipe_connections(i) end))
  if pc and pc[1] then
    local p = s.create_entity{name="pipe", position=pc[1].target_position, force="player"}
    if p then laid = laid + 1 end
  end
end
rcon.print("pipes laid on live ports: " .. laid)
-- a crafting machine takes fluid from the network, not from a script insert, so the ingredient goes
-- into the pipe that sits on its input port cell
local inputs = {}
for i = 1, #fb do
  if fb.get_pipe_connections(i)[1].flow_direction == "input" then
    local pc = fb.get_pipe_connections(i)[1].target_position
    inputs[#inputs+1] = { box = i, at = { x = pc.x, y = pc.y } }
  end
end
local want = ${toLuaWants(recipe)}
for _, spec in ipairs(want) do
  for _, pin in ipairs(inputs) do
    local pipe = s.find_entities_filtered{name="pipe", position=pin.at, radius=0.1}[1]
    if pipe then
      local ok2, v2 = pcall(function()
        return pipe.insert_fluid { name = spec.name, amount = spec.amount * 4, temperature = spec.temperature }
      end)
      rcon.print(string.format("  pipe into live box %d <- %s@%s : %s %s", pin.box, spec.name,
        spec.temperature, tostring(ok2), tostring(v2)))
    end
  end
end
describe(ref, "after feeding the input pipes")`;

const toLuaWants = (recipe) => recipe === "advanced-oil-processing"
  ? `{{name="crude-oil", amount=200, temperature=63}, {name="water", amount=100, temperature=41}}`
  : `{name="crude-oil", amount=200, temperature=63}`;

const read = `if not s then return end
local ref = s.find_entities_filtered{name="oil-refinery", area={{-40,-40},{40,40}}}[1]
if not ref then rcon.print("NO_REFINERY") return end
local rev = {} for k, v in pairs(defines.entity_status) do rev[v] = k end
rcon.print("status=" .. tostring(rev[ref.status]))
describe(ref, "after running")
rcon.print("refinery holds: " .. held(ref))
local rows = {}
for _, p in ipairs(s.find_entities_filtered{name="pipe", area={{-40,-40},{40,40}}}) do
  rows[#rows+1] = string.format("  pipe @ %-11s holds %s", cell(p.position), held(p))
end
table.sort(rows)
rcon.print(table.concat(rows, "\\n"))`;

(async () => {
  await r.ready();
  for (const recipe of ["basic-oil-processing", "advanced-oil-processing"]) {
    console.log(`\n================ ${recipe}`);
    console.log(await r.cmd(PRELUDE + "\n" + setup(recipe)));
    await r.runFor(4000, 60);
    console.log(await r.cmd(PRELUDE + "\n" + read));
  }
  await r.cmd(PRELUDE + `if s then
for _, e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end end
rcon.print("cleared")`);
  r.close();
})();
