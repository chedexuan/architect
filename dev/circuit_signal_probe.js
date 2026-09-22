// Third pass at "can a script put a signal on a circuit network in 2.0", after two script-side
// emitters both came up silent. Discriminates the two explanations left:
//
//   R the read is wrong -- `LuaCircuitNetwork.signals` iterated with pairs() is one code path;
//     `get_signal(signal)` and `LuaEntity::get_signals(...)` are two others. A dict proxy that answers
//     lookups but iterates empty is exactly the shape of `resource_categories` (ipairs over a set table
//     -> empty), which already cost this project a wrong conclusion about pumpjacks.
//   S the surface is wrong -- this rig has been run on `arch-sandbox`, a script-created surface, and
//     that surface class has already lied twice: it has no sun, and production statistics are not
//     counted on it. Pass the surface on the command line to compare.
//
//   node dev/circuit_signal_probe.js                       # arch-sandbox, control
//   node dev/circuit_signal_probe.js nauvis 200 200        # real surface, same rig
//
// Judge that does not depend on the read path: the target assembler has circuit_set_recipe on, so if a
// signal named after a recipe it could build ever reaches it, its recipe stops being nil on its own.
const { execFileSync } = require("child_process");
const run = (src) => execFileSync(process.execPath, ["dev/lua.js", src], { encoding: "utf8", maxBuffer: 1 << 28 });
// speed 60 for ~1.5 real seconds is ~90 game ticks -- far more than a circuit network needs to settle.
const settle = () => execFileSync(process.platform === "win32" ? "ping" : "sleep",
  process.platform === "win32" ? ["-n", "2", "127.0.0.1"] : ["1.5"], { stdio: "ignore" });

const SURFACE = process.argv[2] || "arch-sandbox";
const OX = Number(process.argv[3] || 0);
const OY = Number(process.argv[4] || 0);
const AREA = `{{${OX - 20},${OY - 20}}, {${OX + 20},${OY + 20}}}`;
// On the real map nothing may be cleared by accident, so teardown names exactly what this rig creates.
const NAMES = `{${["assembling-machine-3", "constant-combinator", "electric-energy-interface"].map(n => JSON.stringify(n)).join(", ")}}`;

const HEAD = `local s = game.surfaces[${JSON.stringify(SURFACE)}]
local AREA = ${AREA}
local NAMES = ${NAMES}
local function pp(fmt, ...) rcon.print(string.format(fmt, ...)) end
local function one(name) local e = s.find_entities_filtered{name = name, area = AREA, limit = 1} return e[1] end
local function wipe()
  local n = 0
  for _, name in ipairs(NAMES) do
    for _, e in ipairs(s.find_entities_filtered{name = name, area = AREA}) do e.destroy(); n = n + 1 end
  end
  for _, g in ipairs(s.find_entities_filtered{type = "entity-ghost", area = AREA}) do g.destroy(); n = n + 1 end
  return n
end
local SEEK = {{name = "iron-gear-wheel", type = "item"}, {name = "iron-gear-wheel", type = "recipe"},
              {name = "copper-cable", type = "recipe"}, {name = "signal-1", type = "virtual"}}
local function nets(e, label)
  for _, w in ipairs(e.get_wire_connectors(true)) do
    local cn = e.get_circuit_network(w.wire_connector_id)
    local iter, look = {}, {}
    if cn then
      for k, v in pairs(cn.signals or {}) do
        iter[#iter+1] = (type(k) == "table" and (k.name .. "/" .. tostring(k.type)) or tostring(k)) .. "=" .. tostring(v)
      end
      for _, sg in ipairs(SEEK) do
        local ok, v = pcall(function() return cn.get_signal(sg) end)
        look[#look+1] = string.format("%s/%s=%s", sg.name, sg.type, tostring(ok and v or ("ERR:" .. tostring(v))))
      end
    end
    pp("  %-11s id=%-2s wire=%-2s wires=%s net=%-4s members=%-3s iter=[%s]",
      label, tostring(w.wire_connector_id), tostring(w.wire_type), tostring(w.connection_count),
      tostring(cn and cn.network_id), tostring(cn and cn.connected_circuit_count), table.concat(iter, " "))
    if cn then pp("  %-11s   get_signal -> %s", label, table.concat(look, "  ")) end
  end
  for _, id in ipairs({1, 2, 3, 4}) do
    for _, form in ipairs({{"(nil,id)", function() return e.get_signals(nil, id) end},
                           {"(false,id)", function() return e.get_signals(false, id) end}}) do
      local ok, r = pcall(form[2])
      if not ok then
        pp("  %-11s get_signals%s id=%s -> RAISED %s", label, form[1], id, tostring(r):gsub("[\\r\\n]+", " "):sub(1, 90))
      else
        local t = {}
        for _, sg in ipairs(type(r) == "table" and r or {}) do
          local sid = sg.signal or sg
          t[#t+1] = tostring(sid.name) .. "/" .. tostring(sid.type) .. "=" .. tostring(sg.count)
        end
        pp("  %-11s get_signals%s id=%s -> [%s]", label, form[1], id, table.concat(t, " "))
      end
    end
  end
end
local function dump_section(c)
  local cb = c.get_or_create_control_behavior()
  pp("  comb enabled=%s sections_count=%s", tostring(cb.enabled), tostring(cb.sections_count))
  for _, sec in ipairs(cb.sections or {}) do
    local f = {}
    for i, x in ipairs(sec.filters or {}) do
      local v = x.value
      f[#f+1] = string.format("[%d]{value=%s/%s min=%s max=%s}", i,
        tostring(type(v) == "table" and v.name or v), tostring(type(v) == "table" and v.type),
        tostring(x.min), tostring(x.max))
    end
    pp("  sec#%s manual=%s active=%s mult=%s group=%q filters=[%s]",
      tostring(sec.index), tostring(sec.is_manual), tostring(sec.active),
      tostring(sec.multiplier), tostring(sec.group), table.concat(f, " "))
  end
end
local function target()
  for _, mm in ipairs(s.find_entities_filtered{name = "assembling-machine-3", area = AREA}) do
    local rec = mm.get_recipe()
    pp("  assembler at %s,%s recipe=%s status=%s",
       tostring(mm.position.x), tostring(mm.position.y), tostring(rec and rec.name), tostring(mm.status))
    nets(mm, "assembler")
  end
end
local function report(tag)
  pp("%s", tag)
  local c = one("constant-combinator")
  if c then dump_section(c); nets(c, "combinator") end
  target()
end
pp("surface=%s centre=%s,%s", ${JSON.stringify(SURFACE)}, ${OX}, ${OY})`;

const BUILD = `${HEAD}
pp("wiped %d", wipe())
s.create_global_electric_network()
local m = s.create_entity{name = "assembling-machine-3", position = {x = ${OX}.5, y = ${OY}.5}, force = "player"}
local c = s.create_entity{name = "constant-combinator", position = {x = ${OX + 6}.5, y = ${OY}.5}, force = "player",
  direction = defines.direction.east}
m.insert{name = "iron-plate", count = 400}
m.insert{name = "copper-cable", count = 400}
m.set_recipe("copper-cable")
m.get_or_create_control_behavior().circuit_set_recipe = true
local A, B
for _, w in ipairs(m.get_wire_connectors(true)) do if w.wire_type == defines.wire_type.red then A = w end end
for _, w in ipairs(c.get_wire_connectors(true)) do if w.wire_type == defines.wire_type.red then B = w end end
pp("connect machine[%s] -> comb[%s] = %s", tostring(A.wire_connector_id), tostring(B.wire_connector_id),
   tostring(A.connect_to(B, false, defines.wire_origin.script)))
m.update_connections() c.update_connections()
local sec = c.get_or_create_control_behavior().get_section(1)
sec.active = true sec.multiplier = 1
sec.filters = { {value = {name = "iron-gear-wheel", type = "item"}, max = 1} }
report("built, same tick:")
game.tick_paused = false game.speed = 60`;

const TEARDOWN = `game.tick_paused = true game.speed = 1
${HEAD}
pp("cleared %d", wipe())`;

// H: does the runtime filter struct have any field at all that carries "the value this emits"? The
// blueprint schema calls it `count`, the runtime LogisticFilter documents value/min/max. Writing an
// unknown key on these structs raises rather than being ignored, so accept-vs-raise is the measurement.
const KEYS = `${HEAD}
local c = one("constant-combinator")
local cb = c.get_or_create_control_behavior()
local sec = cb.get_section(1)
local function try(label, f)
  local ok, err = pcall(f)
  pp("  %-58s -> %s %s", label, tostring(ok and "ACCEPTED" or "RAISED"), tostring(ok and "" or err):gsub("[\\r\\n]+", " "))
end
try("cb.parameters = {sections=...}", function() cb.parameters = {sections = {}} end)
try("cb.signals = {...}", function() cb.signals = {{signal = "iron-gear-wheel", count = 1}} end)
try("cb.is_on = true", function() cb.is_on = true end)
try("sec.filters value+count", function()
  sec.filters = { {value = {name = "iron-gear-wheel", type = "item"}, count = 7, max = 7, min = 7} }
end)
try("sec.filters {signal=,count=}", function()
  sec.filters = { {signal = {name = "iron-gear-wheel", type = "item"}, count = 7} }
end)
try("sec.count = 7", function() sec.count = 7 end)
try("sec.set_slot(1, {value=,count=})", function()
  sec.set_slot(1, {value = {name = "iron-gear-wheel", type = "item"}, count = 7})
end)
try("sec.set_slot(1, {value=,min=7,max=7})", function()
  sec.set_slot(1, {value = {name = "iron-gear-wheel", type = "item"}, min = 7, max = 7})
end)
local ok, got = pcall(function() return sec.get_slot(1) end)
pp("  get_slot(1) -> %s %s", tostring(ok), tostring(ok and helpers.table_to_json(got) or got))
sec.filters = { {value = {name = "iron-gear-wheel", type = "item"}, max = 1} }
c.update_connections()`;

// P: the one route the removed set_signal() left open -- let the game build the combinator from a
// blueprint string that carries control_behavior, which is exactly what a player's GUI produces.
const BLUEPRINT = `${HEAD}
wipe()
local m = s.create_entity{name = "assembling-machine-3", position = {x = ${OX}.5, y = ${OY}.5}, force = "player"}
m.insert{name = "iron-plate", count = 400}
m.insert{name = "copper-cable", count = 400}
m.set_recipe("copper-cable")
m.get_or_create_control_behavior().circuit_set_recipe = true
local inv = game.create_inventory(1)
inv.insert{name = "blueprint", count = 1}
local st = inv[1]
st.set_blueprint_entities{{entity_number = 1, name = "constant-combinator",
  position = {x = ${OX + 6}.5, y = ${OY}.5}, direction = defines.direction.east}}
local raw = st.export_stack()
pp("bare combinator exported %d bytes; the game's own schema:", #raw)
pp("  %s", helpers.decode_string(raw))
local t = helpers.json_to_table(helpers.decode_string(raw))
t.blueprint.entities[1].control_behavior = {
  constant_combinator_parameters = {
    is_on = true,
    sections = {{index = 1, active = true, multiplier = 1, filters = {
      {index = 0, name = "iron-gear-wheel", type = "item", count = 7},
      {index = 1, name = "copper-cable", type = "recipe", count = 3},
    }}},
  },
}
local encoded = helpers.encode_string(helpers.table_to_json(t))
local ok, err = pcall(function() return st.import_stack(encoded) end)
pp("import_stack -> %s %s", tostring(ok), tostring(ok and "" or err))
if ok then
  local built = st.build_blueprint{surface = s, position = {x = ${OX + 6}.5, y = ${OY}.5}, force = "player",
    direction = defines.direction.east, raise_built = true}
  pp("build_blueprint -> %s", helpers.table_to_json(built))
  for _, g in ipairs(s.find_entities_filtered{type = "entity-ghost", area = AREA}) do
    local ok2, err2 = pcall(function() return g.silent_revive{raise_revive = true} end)
    pp("  revive %s -> %s %s", tostring(g.ghost_name), tostring(ok2), tostring(ok2 and "" or err2))
  end
  local wired = 0
  local cbent = one("constant-combinator")
  if cbent then
    for _, wc in ipairs(cbent.get_wire_connectors(true)) do
      for _, wm in ipairs(m.get_wire_connectors(true)) do
        if wc.wire_type == wm.wire_type then
          local ok = pcall(function() return wm.connect_to(wc, false, defines.wire_origin.script) end)
          if ok then wired = wired + 1 end
        end
      end
    end
    m.update_connections() cbent.update_connections()
  end
  pp("wired blueprint-built combinator to the assembler on %s connector pairs", wired)
end
inv.destroy()
game.tick_paused = false game.speed = 60`;

console.log(run(BUILD));
settle();
console.log(run(`${HEAD}\nreport("after ~90 ticks:")`));
console.log(run(KEYS)); settle();
console.log(run(`${HEAD}\nreport("H unknown-key probe, each write tried above ->")`));
console.log(run(BLUEPRINT)); settle();
console.log(run(`${HEAD}\nreport("P combinator built from a blueprint string ->")`));
console.log(run(TEARDOWN));
