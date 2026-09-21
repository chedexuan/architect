// Can a circuit signal pick an assembler's recipe in 2.0? Proven: the machine side is real, the
// signal source side is the open question.
//
// The user -- a Factorio player -- stated flatly that this works. My first probe answered "assemblers
// have no control behaviour", which was wrong three times over, and each wrong turn is a doc defect
// rather than a guessing error, so they are written here:
//
// 1. `get_control_behavior()` returns nil until a behaviour exists. 2.0 has
//    `get_or_create_control_behavior()` -- that one call is the difference between "this machine
//    cannot be wired" and the truth below.
// 2. `LuaWireConnector::connect_to` is documented as `(origin, reach_check, target)`; the engine
//    wants `(target, reach_check, origin)`. Found by reading which argument it complained about:
//    `A:connect_to(B)` -> "bool expected, got userdata" means slot 1 was reached by B, i.e. target.
//    The same reversal exists in `LuaLogisticSection::set_slot` (documented `(filter, slot_index)`,
//    JSON `order` fields say slot_index=0, filter=1 -> the real call is `set_slot(1, filter)`), and
//    in `commands.add_command`. `dev/api_query.js` now prints those `order` fields for this reason.
// 3. `LuaEntity.circuit_networks` is gone; it is `LuaEntity:get_circuit_network(connector_id)`.
// 4. `LuaEntity::get_wire_connector` is documented `(or_create, wire_connector_id)`; the engine
//    answers `'wire_connector_id': real number expected got boolean` for that order. It is
//    `(wire_connector_id, or_create)`. A constant combinator only ever enumerates connector ids 1
//    and 2 -- `combinator_output_red`(3) does not exist on it, so "connect to its output side" is a
//    dead end; wiring its red to the machine's red shares one network, which is confirmed.
// 5. Same class of reversal in `LuaLogisticSection::set_slot`: the JSON lists `(filter, slot_index)`
//    but the `order` fields say slot_index=0, filter=1, and the engine wants `set_slot(1, filter)`.
//    Four reversals in one file is why `dev/api_query.js` now prints those `order` fields.
//
// What is PROVEN by running this against the live server:
//
//   machine behaviour: LuaAssemblingMachineControlBehavior
//   cb.circuit_set_recipe := true -> true  (reads back true)
//   readable knobs: circuit_read_working, circuit_read_recipe_finished, circuit_read_contents,
//                   circuit_condition, circuit_enable_disable, connect_to_logistic_network
//   A.connect_to(B, false, defines.wire_origin.script) -> true, both connectors report 1 wire,
//                   machine sees network id 5, connected_circuit_count 2
//   sec.filters = {{value={name="iron-gear-wheel", type="recipe"}, max=1}} -> accepted,
//                   filters_count becomes 1  (LogisticFilter really is {value=, max=}, not {signal=,count=})
//   with circuit_set_recipe on and nothing usable on the wire, m.get_recipe() returns NIL: the machine
//                   stopped using its hand-set recipe and is waiting for the network. That is the
//                   mechanism switching over.
//
// What is NOT yet proven: getting the recipe signal actually onto the network from a script-built
// constant combinator. State as of the last run, all of it read back from the engine:
//
//   machine conn id=1 type=2 net=6 wires_to=[...] signals=[]
//   comb    conn id=1 type=2 net=6 wires_to=[...] signals=[]      <- same network, so the wire is real
//   combinator enabled=true  section.active=true  section.multiplier=1
//   sec.filters = {{value={name="iron-gear-wheel", type="recipe"}, max=1}}
//        -> accepted; reads back stored as `iron-gear-wheel/recipe max=1`
//   and `__RECIPE__<name>` is not a thing: "Unknown virtual-signal name" -- and one bad element
//        aborts the whole `filters` write, which is why a partly-valid list silently emitted nothing.
//
// So: the machine is waiting for a signal (`no_recipe`), the wire carries a shared network id, the
// filter is stored with the right type -- and no signal appears on it. The remaining candidates are
// that a script-written `filters` needs something the GUI does implicitly (a second section field,
// or a per-tick apply), or `value` is the wrong sub-key for emission as `max` is the wrong count.
//
// Cheapest way to settle it: build the same two entities by hand in the client -- a player does this
// in twenty seconds and is certain the feature works -- then read the working combinator's section
// back through this probe and diff it against the script-built one. That is the next action here.
//
// Run: `node dev/circuit_probe.js build`, then `wire`, then `tick`, then `check`; `clear` to tidy.
// Nothing is asserted here on purpose: the assertion belongs to whichever explanation survives.
const { execFileSync } = require("child_process");
const run = (src) => execFileSync(process.execPath, ["dev/lua.js", src], { encoding: "utf8", maxBuffer: 1 << 28 });

const PREAMBLE = `local s = game.surfaces["arch-sandbox"]
local function machine() return s.find_entities_filtered{name="assembling-machine-3", area={{-40,-40},{40,40}}}[1] end
local function comb() return s.find_entities_filtered{name="constant-combinator", area={{-40,-40},{40,40}}}[1] end
local function want(e, id)
  for _, w in ipairs(e.get_wire_connectors(true)) do if w.wire_connector_id == id then return w end end
end
local function list_conn(e, label)
  local l = {}
  for _, w in ipairs(e.get_wire_connectors(true)) do
    l[#l+1] = string.format("%s:%s(wire_type=%s wires=%s)", tostring(w.wire_connector_id),
      tostring(w.object_name):gsub("LuaWireConnector","conn"), tostring(w.wire_type), tostring(w.connection_count))
  end
  rcon.print("  " .. label .. " connectors: " .. table.concat(l, " "))
end
local function report(tag)
  local m, c = machine(), comb()
  if not m or not c then rcon.print(tag .. " MISSING: machine=" .. tostring(m ~= nil) .. " combinator=" .. tostring(c ~= nil)) return end
  local mb, cbh = m.get_or_create_control_behavior(), c.get_or_create_control_behavior()
  local cn = m.get_circuit_network(defines.wire_connector_id.circuit_red)
  local sigs = {}
  if cn then for k, v in pairs(cn.signals or {}) do
    sigs[#sigs+1] = tostring(type(k) == "table" and (k.name .. "/" .. tostring(k.type)) or k) .. "=" .. tostring(v) end end
  local rec = m.get_recipe()
  rcon.print(string.format("%s recipe=%s circuit_set_recipe=%s network=%s signals=[%s] sec.filters_count=%s",
    tag, tostring(rec and rec.name or "nil"), tostring(mb.circuit_set_recipe),
    tostring(cn and cn.network_id), table.concat(sigs, " "),
    tostring(cbh.get_section(1).filters_count)))
  list_conn(m, "machine")
  list_conn(c, "combinator")
end`;

const BUILD = `local s = game.surfaces["arch-sandbox"]
for _, e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end
s.create_global_electric_network()
s.create_entity{name="electric-energy-interface", position={x=-25.5,y=-25.5}, force="player"}
local m = s.create_entity{name="assembling-machine-3", position={x=0.5,y=0.5}, force="player"}
local c = s.create_entity{name="constant-combinator", position={x=6.5,y=0.5}, force="player",
  direction=defines.direction.east}
m.insert{name="iron-plate", count=400}
m.insert{name="copper-cable", count=400}
m.set_recipe("copper-cable")
local mb = m.get_or_create_control_behavior()
mb.circuit_set_recipe = true
local sec = c.get_or_create_control_behavior().get_section(1)
sec.active = true
sec.filters = { {value = {name = "iron-gear-wheel", type = "recipe"}, max = 1} }
report("built:")
game.tick_paused = false game.speed = 60`;

const WIRE = `local m, c = machine(), comb()
local A, B = want(m, defines.wire_connector_id.circuit_red), want(c, defines.wire_connector_id.circuit_red)
rcon.print("machine red=" .. tostring(A ~= nil) .. " combinator red(input)=" .. tostring(B ~= nil)
  .. " combinator output_red=" .. tostring(want(c, defines.wire_connector_id.combinator_output_red) ~= nil))
local ok, err = pcall(function() return A.connect_to(B, false, defines.wire_origin.script) end)
rcon.print("connect_to(input red) -> " .. tostring(ok) .. " " .. tostring(err))
m.update_connections()
report("wired:")`;

const TICK = `local s = game.surfaces["arch-sandbox"]
game.tick_paused = false game.speed = 60
rcon.print("running")`;

const CHECK = `game.tick_paused = true game.speed = 1
report("after ticks:")`;

const step = process.argv[2] || "build";
const bodies = { build: BUILD, wire: WIRE, tick: TICK, check: CHECK,
  clear: `local s = game.surfaces["arch-sandbox"]
for _, e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end
rcon.print("cleared")` };
console.log(run(PREAMBLE + "\n" + (bodies[step] || bodies.build)));
